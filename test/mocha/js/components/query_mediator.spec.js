/**
 * Created by rchyla on 3/31/14.
 */

define(['underscore', 'jquery', 'js/components/query_mediator', 'js/components/beehive',
        'js/services/pubsub', 'js/services/api', 'js/components/generic_module',
        'js/components/pubsub_key', 'js/components/api_query', 'js/components/api_request'
        ],
  function(_, $, QueryMediator, BeeHive, PubSub, Api, GenericModule, PubSubKey, ApiQuery, ApiRequest) {


    var beehive, debug = false;
    beforeEach(function(done) {
      this.server = sinon.fakeServer.create();
      this.server.autoRespond = true;
      this.server.respondWith(/\/api\/1\/search.*/,
        [200, { "Content-Type": "application/json" }, validResponse]);

      beehive = new BeeHive();
      beehive.addService('Api', new Api());
      beehive.addService('PubSub', new PubSub());
      done();
    });

    afterEach(function(done) {
      beehive.close();
      beehive = null;
      this.server.restore();
      done();
    });

    describe('Query Mediator (Scaffolding)', function() {

      it("returns QueryMediator object", function(done) {
        expect(new QueryMediator()).to.be.instanceof(QueryMediator);
        expect(new QueryMediator()).to.be.instanceof(GenericModule);
        done();
      });

      it("has 'activate' function - which does the appropriate setup", function(done) {
        var qm = new QueryMediator();
        var pubsub = beehive.Services.get('PubSub');

        sinon.stub(pubsub, 'subscribe');
        qm.activate(beehive);

        expect(qm.hasBeeHive()).to.be.true;
        expect(qm.getBeeHive()).to.be.equal(beehive);
        expect(qm.mediatorPubSubKey).to.be.instanceof(PubSubKey);

        expect(pubsub.subscribe.callCount).to.be.eql(2);
        expect(pubsub.subscribe.args[0].slice(0,2)).to.be.eql([qm.mediatorPubSubKey, pubsub.NEW_QUERY]);
        expect(pubsub.subscribe.args[1].slice(0,2)).to.be.eql([qm.mediatorPubSubKey, pubsub.DELIVERING_REQUEST]);

        done();
      });

      it("should mediate between modules; passing data back and forth", function(done) {
        var qm = new QueryMediator({'debug': debug});
        qm.activate(beehive);

        // install spies into pubsub and api
        var pubsub = beehive.Services.get('PubSub');
        var pubsubSpy = sinon.spy(function(){if (debug) {console.log('[pubsub:all]', arguments)}});
        pubsub.on('all', pubsubSpy);
        var api = beehive.Services.get('Api');
        var apiSpy = sinon.spy(function(){if (debug) {console.log('[api:all]', arguments)}});
        api.on('all', apiSpy);

        // test counter for number of responses received
        var globalCounter = 0;

        // create fake UI widgets that simulate interaction with mediator
        // they send signals and receive responses
        var M = GenericModule.extend({
          activate: function(beehive) {
            this.bee = beehive;
            pubsub = beehive.Services.get('PubSub');
            pubsub.subscribe(pubsub.INVITING_REQUEST, _.bind(this.sendRequest, this));
            pubsub.subscribe(pubsub.DELIVERING_RESPONSE, _.bind(this.receiveResponse, this));
          },
          userAction: function(q) {
            if (debug)
              console.log('[' + this.mid + '] User Action:', q.url());
            var pubsub = this.bee.Services.get('PubSub');
            pubsub.publish(pubsub.NEW_QUERY, q);
          },
          sendRequest: function(q) {
            q = q.clone();
            q.unlock();
            q.add('q', 'field:' + this.mid);
            var pubsub = this.bee.Services.get('PubSub');
            var r = new ApiRequest({target: 'search', query:q});

            if (debug)
              console.log('[' + this.mid + '] Returning Request:', r.url());
            pubsub.publish(pubsub.DELIVERING_REQUEST, r);
            this._q = q;
          },
          receiveResponse: function(r) {
            if (debug)
              console.log('[' + this.mid + '] Receiving Response:', JSON.stringify(r.toJSON()));

            // do something with response...
            expect(r.get('responseHeader.QTime')).to.equal(88);
            // check the query was the same
            expect(r.getApiQuery().url()).to.equal(this._q.url());
            // actually, even the same instance
            expect(r.getApiQuery()).to.equal(this._q);

            globalCounter += 1;
            if (globalCounter > 1) {
              if (debug)
                console.log('test: closing');
              checkIt();
              done();
            }
          }
        });

        // create components
        var m1 = new M();
        var m2 = new M();

        // install spies into components
        sinon.spy(m1, 'sendRequest', m1.sendRequest);
        sinon.spy(m1, 'receiveResponse', m1.receiveResponse);
        sinon.spy(m2, 'sendRequest', m2.sendRequest);
        sinon.spy(m2, 'receiveResponse', m2.receiveResponse);

        // because of the spies, we must activate only now...
        m1.activate(beehive.getHardenedInstance());
        m2.activate(beehive.getHardenedInstance());

        // pretend user clicked and a new query is fired
        var q = new ApiQuery({'q': '*:*'});
        m1.userAction(q);

        /*
         whole chain of events should happen:
         - user clicked: NEW_QUERY
         - mediator issues: INVITING_REQUEST
           - m1 and m2 respond with: DELIVERING_REQUEST
         - mediator calls api: api.request(apiRequest)
           - api gets data and sends them back to mediator
           - mediator wraps it into ApiResponse and issues: DELIVERING_RESPONSE
              - m1 & m2 receive the apiResponse (each for their own request only)
        */

        // must be called after we have collected everything
        var checkIt = function() {
          // each was called once
          expect(m1.sendRequest.callCount).to.be.equal(1);
          expect(m2.sendRequest.callCount).to.be.equal(1);

          // they received a clone of the query (but not the original)
          expect(m1.sendRequest.args[0][0].url()).to.equal(q.url());
          expect(m2.sendRequest.args[0][0].url()).to.equal(q.url());
          expect(m1.sendRequest.args[0][0]).to.not.equal(q);
          expect(m2.sendRequest.args[0][0]).to.not.equal(q);
          // and it was 'locked'
          expect(m1.sendRequest.args[0][0].isLocked()).to.be.true;
          expect(m2.sendRequest.args[0][0].isLocked()).to.be.true;

          // each UI must receive only its own data
          expect(m1.receiveResponse.callCount).to.be.equal(1);
          expect(m2.receiveResponse.callCount).to.be.equal(1);
        }

        if (debug)
          console.log('test: reached end');
      });
    });


    var validResponse = '{\
      "responseHeader":{\
        "status":0,\
          "QTime":88,\
          "params":{\
          "facet":"true",\
            "indent":"true",\
            "hl.simple.pre":"<em>",\
            "hl.fl":"title",\
            "wt":"json",\
            "hl":"true",\
            "rows":"5",\
            "fl":"title,bibcode,author",\
            "start":"10",\
            "facet.query":"title:star",\
            "q":"title:star",\
            "hl.simple.post":"</em>",\
            "facet.field":"author",\
            "fq":"database:astronomy"}},\
      "response":{"numFound":172978,"start":10,"docs":[\
        {\
          "author":["Morrison, J."],\
          "bibcode":"1903PA.....11...88M",\
          "title":["The Star of Bethlehem"]},\
        {\
          "author":["Morrison, J."],\
          "bibcode":"1903PA.....11..122M",\
          "title":["The Star of Bethlehem (cont.)"]},\
        {\
          "author":["Wing, Daniel E."],\
          "bibcode":"1903PA.....11..481W",\
          "title":["Star Dust"]},\
        {\
          "bibcode":"1906PA.....14R.507.",\
          "title":["Star Charts"]},\
        {\
          "author":["Holmes, Edwin"],\
          "bibcode":"1894JBAA....5...26H",\
          "title":["Star Streams"]}]\
      },\
      "facet_counts":{\
        "facet_queries":{\
          "title:star":172978},\
        "facet_fields":{\
          "author":[\
            "heber, u",301,\
            "linsky, j l",299,\
            "mayor, m",273,\
            "kurtz, d w",270,\
            "pickering, edward c",262,\
            "maeder, a",260,\
            "schmitt, j h m m",259,\
            "campbell, leon",256,\
            "mundt, r",138]},\
        "facet_dates":{},\
        "facet_ranges":{}},\
      "highlighting":{\
        "166243":{\
          "title":["The <em>Star</em> of Bethlehem"]},\
        "166285":{\
          "title":["The <em>Star</em> of Bethlehem (cont.)"]},\
        "166785":{\
          "title":["<em>Star</em> Dust"]},\
        "192734":{\
          "title":["<em>Star</em> Charts"]},\
        "139757":{\
          "title":["<em>Star</em> Streams"]}}}';


});
